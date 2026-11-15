import {
  emailDomainAllowed,
  emailMatchesConfiguredDomain,
  maskEmail,
  maskStudentNumber,
  normalizeDomain,
} from './university-email';
import { universityIdentityOf } from './university-identity';
import { pickStudentIdentifier } from './student-lookup';

describe('university identity rules', () => {
  const student = { role: 'STUDENT', universityId: 'u1' };

  it('STUDENT: complete with a student number OR a verified university e-mail', () => {
    expect(universityIdentityOf(student)).toMatchObject({
      required: true,
      complete: false,
      satisfiedBy: [],
    });
    expect(
      universityIdentityOf({ ...student, studentNumber: 'S-1' }).satisfiedBy,
    ).toEqual(['STUDENT_NUMBER']);
    // unverified address does not count and is not exposed as universityEmail
    expect(
      universityIdentityOf({ ...student, universityEmail: 'a@u.edu' }),
    ).toMatchObject({ complete: false, universityEmail: null });
    expect(
      universityIdentityOf({
        ...student,
        universityEmail: 'a@u.edu',
        universityEmailVerifiedAt: new Date(),
      }).satisfiedBy,
    ).toEqual(['UNIVERSITY_EMAIL']);
    // a student number needs a university
    expect(
      universityIdentityOf({
        ...student,
        universityId: null,
        studentNumber: 'S-1',
      }).complete,
    ).toBe(false);
  });

  it('SUPERVISOR and ADMIN are never required to have one', () => {
    for (const role of ['SUPERVISOR', 'ADMIN']) {
      expect(universityIdentityOf({ role, universityId: null })).toMatchObject({
        required: false,
        complete: true,
      });
    }
  });

  it('domains: optional until configured; exact domain or subdomain; never a look-alike', () => {
    // no domains configured: any address except personal mailbox providers
    expect(emailDomainAllowed('a@uni.example', [])).toBe(true);
    expect(emailDomainAllowed('a@gmail.com', [])).toBe(false);
    expect(emailDomainAllowed('a@Outlook.com', [])).toBe(false);
    expect(emailDomainAllowed('a@um.edu.sa', ['UM.edu.sa'])).toBe(true);
    expect(emailDomainAllowed('a@student.um.edu.sa', ['@um.edu.sa'])).toBe(
      true,
    );
    expect(emailDomainAllowed('a@notum.edu.sa', ['um.edu.sa'])).toBe(false);
    expect(emailDomainAllowed('a@um.edu.sa.evil.com', ['um.edu.sa'])).toBe(
      false,
    );
    expect(emailMatchesConfiguredDomain('a@gmail.com', [])).toBe(false);
    expect(normalizeDomain(' .Um.Edu.Sa ')).toBe('um.edu.sa');
  });

  it('masks identifiers', () => {
    expect(maskEmail('hala.r@um.edu.sa')).toBe('h***@um.edu.sa');
    expect(maskStudentNumber('2026001234')).toBe('20******34');
    expect(maskStudentNumber('ABC')).toBe('A**');
  });

  it('exactly one identifier to search or invite', () => {
    expect(pickStudentIdentifier({ studentNumber: 'S-1' })).toEqual({
      type: 'STUDENT_NUMBER',
      value: 'S-1',
    });
    expect(pickStudentIdentifier({ universityEmail: 'a@u.edu' }).type).toBe(
      'UNIVERSITY_EMAIL',
    );
    expect(() => pickStudentIdentifier({})).toThrow();
    expect(() =>
      pickStudentIdentifier({
        studentNumber: 'S-1',
        universityEmail: 'a@u.edu',
      }),
    ).toThrow();
  });
});
